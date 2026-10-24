'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from './supabase';

const RELAY_URL = process.env.NEXT_PUBLIC_RELAY_URL;
const BUFFER_MS = 5 * 60 * 1000;
const MAX_LOG = 300;

// Live connection to the relay. Re-authenticates with a fresh session on every reconnect.
export function useRelay(enabled) {
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState({ duck_connected: false, with_you: false });
  const [events, setEvents] = useState([]);
  const [lastAck, setLastAck] = useState(null);
  const wsRef = useRef(null);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let retry = null;
    let backoff = 1000;

    async function connect() {
      const { data } = await supabase.auth.getSession();
      if (stopped || !data.session) return;

      const ws = new WebSocket(RELAY_URL);
      wsRef.current = ws;

      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', role: 'dashboard', access_token: data.session.access_token }));
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'auth_ok') { setConnected(true); backoff = 1000; }
        else if (msg.type === 'buffer') setEvents(msg.events);
        else if (msg.type === 'event') setEvents((prev) => [...prev, msg.event].slice(-MAX_LOG));
        else if (msg.type === 'status') setStatus(msg);
        else if (msg.type === 'command_ack') setLastAck({ ...msg, at: Date.now() });
      };
      ws.onclose = (e) => {
        setConnected(false);
        setStatus({ duck_connected: false, with_you: false });
        if (stopped) return;
        if (e.code === 4003) supabase.auth.refreshSession(); // stale token: refresh before retrying
        retry = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 10000);
      };
    }

    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [enabled]);

  const send = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
  }, []);

  return { connected, status, events, lastAck, send, bufferMs: BUFFER_MS };
}
