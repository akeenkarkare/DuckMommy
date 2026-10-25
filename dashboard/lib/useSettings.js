'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from './supabase';

// The user's settings row. Saves to Supabase on change (RLS: own row only), then
// calls onSaved so the relay pushes the new settings to the duck.
export function useSettings(userId, onSaved) {
  const [settings, setSettings] = useState(null);
  const [state, setState] = useState('');
  const timer = useRef(null);
  const pending = useRef({});
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  useEffect(() => {
    if (!userId) return;
    supabase.from('settings').select('*').eq('user_id', userId).single()
      .then(({ data, error }) => (error ? setState(error.message) : setSettings(data)));
    return () => clearTimeout(timer.current);
  }, [userId]);

  const save = useCallback(async () => {
    const patch = pending.current;
    pending.current = {};
    const { error } = await supabase.from('settings').update(patch).eq('user_id', userId);
    if (error) return setState(`Not saved: ${error.message}`);
    setState('Saved');
    onSavedRef.current?.();
  }, [userId]);

  const change = useCallback((key, value, debounceMs = 500) => {
    setSettings((s) => ({ ...s, [key]: value }));
    pending.current[key] = value;
    setState('Saving…');
    clearTimeout(timer.current);
    timer.current = setTimeout(save, debounceMs);
  }, [save]);

  // A change made elsewhere (e.g. "hey duck, sentry mode on" via the relay): show it, don't re-save it.
  const apply = useCallback((patch) => setSettings((s) => (s ? { ...s, ...patch } : s)), []);

  return { settings, change, apply, state };
}
