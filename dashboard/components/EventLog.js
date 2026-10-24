const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

function describe({ type, value: v }) {
  if (!v) return '';
  switch (type) {
    case 'posture':
      return v.state === 'slouch'
        ? `Slouching ${v.slouch_duration_s}s · neck ${v.neck_angle_deg}°`
        : `Sat up after ${v.slouch_duration_s}s · neck ${v.neck_angle_deg}°`;
    case 'pat': return `Head pat (${v.touch_ms} ms)`;
    case 'presence': return v.present ? `Arrived · ${v.distance_cm} cm away` : 'Left the desk';
    case 'sentry': return v.person_confirmed
      ? `Person spotted · ${Math.round(v.confidence * 100)}% sure · ${v.distance_cm} cm`
      : `Motion, no person (${Math.round(v.confidence * 100)}%)`;
    case 'focus': return 'NFC tag tapped';
    default: return JSON.stringify(v);
  }
}

export default function EventLog({ events }) {
  const rows = [...events].reverse().slice(0, 100);
  return (
    <div className="card">
      <h2>Live events <span className="sub">newest first</span></h2>
      {rows.length === 0 ? (
        <p className="empty">Nothing yet. Events show up here as the duck sends them.</p>
      ) : (
        <div className="log-wrap">
          <table className="log">
            <thead><tr><th>Time</th><th>Type</th><th>Details</th></tr></thead>
            <tbody>
              {rows.map((e, i) => (
                <tr key={`${e.ts}-${i}`}>
                  <td className="time">{clock(e.ts)}</td>
                  <td className="type">{e.type}</td>
                  <td>{describe(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
