'use client';

import { useState } from 'react';

const BIN_MS = 30 * 1000;
const W = 380, H = 150;   // ~ the drawer's width, so the 11px axis text isn't scaled down to 6px
const M = { top: 10, right: 4, bottom: 24, left: 28 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;
const GAP = 2;
const R = 4;

const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

// Bar with a rounded top, square at the baseline.
function barPath(x, y, w, h) {
  const r = Math.min(R, h, w / 2);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

export default function SlouchChart({ events, now, windowMs }) {
  const [hover, setHover] = useState(null);
  const bins = Math.round(windowMs / BIN_MS);
  const start = now - windowMs;

  const counts = Array.from({ length: bins }, () => 0);
  for (const e of events) {
    if (e.type !== 'posture' || e.value?.state !== 'slouch' || e.ts < start || e.ts > now) continue;
    counts[Math.min(bins - 1, Math.floor((e.ts - start) / BIN_MS))] += 1;
  }

  const max = Math.max(...counts);
  const yMax = Math.max(3, max);
  const step = Math.ceil(yMax / 3);
  const ticks = Array.from({ length: Math.floor(yMax / step) + 1 }, (_, i) => i * step);
  const top = ticks[ticks.length - 1];
  const y = (v) => M.top + PLOT_H - (v / top) * PLOT_H;
  const binW = PLOT_W / bins;

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Slouch prompts per 30 seconds, last 5 minutes. Total ${counts.reduce((a, b) => a + b, 0)}.`}>
        {ticks.map((t) => (
          <g key={t}>
            <line className={t === 0 ? 'baseline' : 'gridline'} x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} />
            <text className="axis" x={M.left - 8} y={y(t) + 4} textAnchor="end">{t}</text>
          </g>
        ))}

        {counts.map((c, i) => {
          const x = M.left + i * binW;
          const h = y(0) - y(c);
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect className="hit" x={x} y={M.top} width={binW} height={PLOT_H} />
              {c > 0 && <path className={`bar${hover === i ? ' active' : ''}`} d={barPath(x + GAP / 2, y(c), binW - GAP, h)} />}
            </g>
          );
        })}

        {Array.from({ length: windowMs / 60000 + 1 }, (_, m) => {
          const minsAgo = windowMs / 60000 - m;
          return (
            <text key={m} className="axis" x={M.left + (m * 60000 / windowMs) * PLOT_W} y={H - 6}
              textAnchor={m === 0 ? 'start' : minsAgo === 0 ? 'end' : 'middle'}>
              {minsAgo === 0 ? 'now' : `−${minsAgo}m`}
            </text>
          );
        })}
      </svg>

      {hover !== null && (
        <div className="tooltip" style={{
          left: `${((M.left + (hover + 0.5) * binW) / W) * 100}%`,
          top: `${(Math.max(y(counts[hover]), M.top + 18) / H) * 100}%`,
        }}>
          <strong>{counts[hover]}</strong> slouch prompt{counts[hover] === 1 ? '' : 's'}<br />
          <span className="hint">{clock(start + hover * BIN_MS)} – {clock(start + (hover + 1) * BIN_MS)}</span>
        </div>
      )}
    </div>
  );
}
