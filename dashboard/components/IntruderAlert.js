'use client';

import { useEffect } from 'react';

// "Possible intruder" pop-up for a confirmed sentry event: alarm beeps, a flashing tab title and,
// when the browser allows it, a desktop notification. Watch feed opens the live view;
// It's me turns sentry off, which tells the duck to welcome you normally.

export function desktopAlertsState() {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  if (!window.isSecureContext) return 'insecure';   // http://<ip>: browsers only allow it on https/localhost
  return Notification.permission;                   // 'default' | 'granted' | 'denied'
}

export function raiseIntruderAlarm() {
  try {   // three short two-tone beeps
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < 6; i++) {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = i % 2 ? 660 : 880;
      gain.gain.value = 0.08;
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.22);
      osc.stop(ctx.currentTime + i * 0.22 + 0.18);
    }
    setTimeout(() => ctx.close(), 2000);
  } catch { /* no audio until the page has been clicked once */ }
  if (desktopAlertsState() === 'granted') {
    try {
      const n = new Notification('🚨 Possible intruder at your desk', {
        body: 'The duck spotted someone while sentry mode is on. Open the dashboard to watch the feed.',
        tag: 'duck-sentry',
        requireInteraction: true,
      });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* some browsers only allow notifications from a service worker */ }
  }
}

export default function IntruderAlert({ alert, onWatch, onMine, onDismiss }) {
  useEffect(() => {   // flash the tab title until it's handled
    if (!alert) return;
    const original = document.title;
    let flip = false;
    const id = setInterval(() => { flip = !flip; document.title = flip ? '🚨 Intruder?' : original; }, 1000);
    return () => { clearInterval(id); document.title = original; };
  }, [alert]);

  if (!alert) return null;
  const at = new Date(alert.event.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const night = alert.event.value?.night ? ' · night vision' : '';

  if (alert.compact) {
    return (
      <div className="intruder-banner glass" role="status">
        <span>🚨 Possible intruder · {at}{night}</span>
        <button className="btn" onClick={onMine}>It's me</button>
        <button className="btn icon" aria-label="Dismiss" onClick={onDismiss}>✕</button>
      </div>
    );
  }
  return (
    <div className="intruder-backdrop" role="alertdialog" aria-modal="true" aria-labelledby="intruder-title">
      <div className="intruder glass">
        <div className="intruder-icon" aria-hidden>🚨</div>
        <h2 id="intruder-title">Possible intruder at your desk</h2>
        <p>The duck spotted someone at {at}{night} while sentry mode is on.</p>
        <div className="row">
          <button className="btn primary" onClick={onWatch}>📷 Watch feed</button>
          <button className="btn" onClick={onMine}>It's me · turn sentry off</button>
        </div>
        <button className="btn link" onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}
