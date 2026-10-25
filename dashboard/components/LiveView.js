'use client';

import { useEffect, useRef, useState } from 'react';

// Live camera view from the duck, through the relay. Opt-in: nothing streams until you press Watch,
// and it stops when you close it or leave the panel. Frames are shown and dropped, never saved.
export default function LiveView({ watch, video, canCommand, autoStart = 0 }) {
  const [on, setOn] = useState(autoStart > 0);
  const [lastFrame, setLastFrame] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const imgRef = useRef(null);
  const urlRef = useRef(null);

  useEffect(() => {   // "Watch feed" on the intruder alert
    if (autoStart > 0) setOn(true);
  }, [autoStart]);

  useEffect(() => {
    if (!on) return;
    const stop = watch((blob) => {
      const url = URL.createObjectURL(blob);
      if (imgRef.current) imgRef.current.src = url;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setLastFrame(Date.now());
    });
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stop();
      clearInterval(tick);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [on, watch]);

  const stale = on && (!lastFrame || now - lastFrame > 3000);
  let note = null;
  if (on && video.reason) note = video.reason;
  else if (on && stale) note = video.streaming
    ? "Waiting for the camera… it's off while nobody's at the desk."
    : 'Connecting…';

  return (
    <div className="card live">
      <h2>
        Live view <span className="sub">{on && !stale ? `${video.fps} fps · not recorded` : 'what the duck sees'}</span>
      </h2>
      {on ? (
        <div className="live-frame">
          <img ref={imgRef} alt="Live camera view from the duck" style={{ opacity: stale ? 0.35 : 1, visibility: lastFrame ? 'visible' : 'hidden' }} />
          {note && <p className="live-note">{note}</p>}
        </div>
      ) : (
        <p className="hint" style={{ margin: 0 }}>See the duck's camera with the posture skeleton drawn on. Only streams while this is open.</p>
      )}
      <div className="row">
        <button className={on ? 'btn' : 'btn primary'} disabled={!on && !canCommand} onClick={() => setOn(!on)}>
          {on ? 'Stop' : '📷 Watch live'}
        </button>
        {!on && !canCommand && <span className="hint">Duck offline</span>}
      </div>
    </div>
  );
}
