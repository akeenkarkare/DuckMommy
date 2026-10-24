'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from './supabase';

const RELAY_URL = process.env.NEXT_PUBLIC_RELAY_URL;
const BUFFER_MS = 5 * 60 * 1000;
const MAX_LOG = 300;

// Live connection to the relay. Re-authenticates with a fresh session on every reconnect.
// onEvent(event) fires for live events only (not the replayed buffer), e.g. to animate the duck.
export function useRelay(enabled, onEvent) {
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState({ duck_connected: false, with_you: false });
  const [events, setEvents] = useState([]);
  const [lastAck, setLastAck] = useState(null);
  const [agenda, setAgenda] = useState({ items: [], errors: [], feeds: 0, fetched_at: null });
  const [video, setVideo] = useState({ streaming: false, reason: null, fps: 0 });
  const wsRef = useRef(null);
  const frameRef = useRef(null);       // live-view frame handler (Blob of a JPEG), set by <LiveView>
  const watchingRef = useRef(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

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

      ws.binaryType = 'blob';
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', role: 'dashboard', access_token: data.session.access_token }));
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') { frameRef.current?.(e.data); return; }   // live-view frame
        const msg = JSON.parse(e.data);
        if (msg.type === 'auth_ok') {
          setConnected(true); backoff = 1000;
          if (watchingRef.current) ws.send(JSON.stringify({ type: 'video', on: true }));   // resume after reconnect
        }
        else if (msg.type === 'buffer') setEvents(msg.events);
        else if (msg.type === 'event') {
          setEvents((prev) => [...prev, msg.event].slice(-MAX_LOG));
          onEventRef.current?.(msg.event);
        }
        else if (msg.type === 'status') setStatus(msg);
        else if (msg.type === 'command_ack') setLastAck({ ...msg, at: Date.now() });
        else if (msg.type === 'agenda') setAgenda(msg);
        else if (msg.type === 'video_status') setVideo(msg);
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

  // Live view: watch(fn) starts frames (fn gets each JPEG Blob) and returns a stop function.
  const watch = useCallback((onFrame) => {
    frameRef.current = onFrame;
    watchingRef.current = true;
    send({ type: 'video', on: true });
    return () => {
      frameRef.current = null;
      watchingRef.current = false;
      send({ type: 'video', on: false });
      setVideo({ streaming: false, reason: null, fps: 0 });
    };
  }, [send]);

  return { connected, status, events, lastAck, send, agenda, video, watch, bufferMs: BUFFER_MS };
}
