const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// Sign to Duck: the latest ASL translations, big enough to read across a room.
export default function SignCard({ events }) {
  const signs = events.filter((e) => e.type === 'sign').slice(-4).reverse();
  return (
    <div className="card">
      <h2>Sign to Duck <span className="sub">ASL → speech</span></h2>
      {signs.length === 0 ? (
        <p className="empty">Sign to the duck and it reads your signs out loud.</p>
      ) : (
        <ul className="signs">
          {signs.map((e, i) => (
            <li key={`${e.ts}-${i}`} className={i === 0 ? 'latest' : ''}>
              <span>“{e.value?.text}”</span>
              <span className="hint">{clock(e.ts)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
