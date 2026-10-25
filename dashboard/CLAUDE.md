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
   - **Sign to Duck card:** latest ASL translations, in large text
   - **Test controls:** e.g. a "say it now" button, sent through the relay to the duck
   - **Focus & coach** panel (the duck's back): focus session buttons (sent as `command {type:"coach", name}`), what the duck said (`coach` events), coach on/off, check-in length, personality (gentle / coach / savage)
   - **Nest** panel (`components/NestPanel.js`): the user's saved memories from the `memories` table (newest first, search, add a typed note, forget one). Reloads on a live `memory` event; shows the duck's last recall answer; says where speech goes (ElevenLabs, Anthropic).
   - **Calendar** panel: "Up next" from the relay's `agenda` message, feed errors, the calendar links field (`settings.calendar_urls`), refresh (`agenda_refresh`)
4. **Intruder alert** (`components/IntruderAlert.js`): a live confirmed `sentry` event pops up "Possible intruder" with beeps, a flashing tab title and a desktop notification when allowed (needs https or localhost). Watch feed opens the Camera panel's live view; It's me turns sentry off. The relay's `settings_patch` (voice sentry on/off) updates the toggles (`useSettings().apply`).
5. **Live view** (Camera panel, `components/LiveView.js`): opt-in "Watch live" shows the duck's annotated camera frames from the relay (`useRelay().watch`). Any logged-in user the duck is with (the relay's `VIDEO_VIEWERS` can restrict it); stops when closed; never recorded.

## Design: the 3D duck
- `components/duck/DuckStage.js` is one three.js scene mounted in `app/layout.js`, so it never unmounts. `/login` and `/register` show the **hero** close-up; `/` shows the **dashboard** duck with labels. Changing route eases between the two, with a spin.
- The duck is built from primitives in `components/duck/buildDuck.js`; there's no model file. The hardware hotspots (camera eye, touch ring, beak, mic grille, NFC tag) are listed in `components/duck/hotspots.js`.
- `components/duck/DuckContext.js`: `focus` (which part is zoomed; opens that part's panel in `components/Panels.js`), `badges` (live text under the labels), and `bridge.react(event)`, which animates the duck for live events (pat → squish, slouch → head shake, sign → speech bubble, sound → mic ripples, sentry → red lens).
- Interaction: drag to spin and tilt (up to a top view); click a part or label to zoom in; click the head to make the real duck quack; Esc or a click on empty space zooms back out.
- Theme is dark-only (the duck is the light source). Respects `prefers-reduced-motion`.
- Dependency: `three` (no react-three-fiber).

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
