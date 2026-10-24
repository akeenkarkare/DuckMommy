# Dashboard — context

Web frontend. Each logged-in user sees and controls only their own duck. Root rules in `/CLAUDE.md` apply. Start plain; add the duck theme last.

## Stack
- **Next.js**
- **Supabase Auth** for register + login
- **Settings and profile:** read and written from Next.js to Supabase using the user's session, with RLS enforcing ownership. Saved as soon as they change.
- **Events:** live over a WebSocket from the Node relay, **not stored**. On connect, the relay sends its 5-minute in-memory buffer of recent events, so the graph survives a refresh.

## Pages
1. **Register:** email, password, display name (sent as `display_name` in the sign-up metadata, which creates the profile + default settings).
2. **Login**
3. **Dashboard** (requires login):
   - **Live data stream:** `posture`, `pat`, `sentry`, `focus`, `presence` as they arrive
   - **Posture-over-time graph** (demo-critical): slouch events per minute over the last 5 minutes, from the buffer + live stream. This doesn't depend on the posture payload. Once the payload exists, it can plot a posture score.
   - **Event log:** newest first, every event type
   - **Duck status:** shows whether the duck is connected and with this user. If another user logs in, the duck moves to them and this page shows that.
   - **Settings:** volume, spoken messages (TTS on the duck), posture severity + delay (placeholder), sentry/quack toggles. Saved to Supabase on change, and the relay pushes them to the duck.
   - **Test controls:** e.g. a "say it now" button, sent through the relay to the duck
4. Not in scope: the live camera feed (video stays on the Pi).

## Schema
See `/backend/supabase/schema.sql` (`profiles`, `settings`).

## Demo check
A judge registers, slouches, and within a few seconds the event appears on the live stream and the posture graph.

## Open questions
None right now.

## Commands
- Install: `npm install` (in `/dashboard`)
- Run: `npm run dev` → http://localhost:3000 (the relay must be running)
- Build: `npm run build`
- Code: plain JS, App Router, no CSS framework. `lib/useRelay.js` (WS + reconnect), `components/` (chart, settings, log, auth form)

## Decisions log
- 2026-10-23: Stack is Next.js + Supabase Auth.
- 2026-10-23: Events are live over a WebSocket from the Node relay and not stored. The relay's in-memory buffer covers refreshes.
- 2026-10-23: Settings are saved to Supabase from Next.js on change. The relay picks them up and pushes them to the duck.
- 2026-10-23: Register + login pages come before the dashboard.
- 2026-10-23: The posture graph shows slouch events per minute until a posture score exists. A duck-status indicator shows when another user has the duck.
