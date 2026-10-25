# Dashboard — context

Web frontend. Each logged-in user sees and controls only their own duck. Root rules in `/CLAUDE.md` apply. Start plain; add the duck theme last.

## Stack
- **Next.js**
- **Supabase Auth** for register + login
- **Settings and profile:** read and written from Next.js to Supabase using the user's session, with RLS enforcing ownership. Saved as soon as they change.
- **Events:** live over a WebSocket from the Node relay, **not stored**. On connect, the relay sends its 5-minute in-memory buffer of recent events, so the graph survives a refresh.

## Pages
0. **Welcome** (`/welcome`, logged out): the scroll-driven landing page below.
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
4. **Live view** (Camera panel, `components/LiveView.js`): opt-in "Watch live" shows the duck's annotated camera frames from the relay (`useRelay().watch`). Any logged-in user the duck is with (the relay's `VIDEO_VIEWERS` can restrict it); stops when closed; never recorded.

## Design: the 3D duck
- `components/duck/DuckStage.js` is one three.js scene mounted in `app/layout.js`, so it never unmounts. `/login` and `/register` show the **hero** close-up; `/` shows the **dashboard** duck with labels. Changing route eases between the two, with a spin.
- The duck is built from primitives in `components/duck/buildDuck.js`; there's no model file. The hardware hotspots (camera eye, touch ring, beak, mic grille, NFC tag) are listed in `components/duck/hotspots.js`.
- `components/duck/DuckContext.js`: `focus` (which part is zoomed; opens that part's panel in `components/Panels.js`), `badges` (live text under the labels), and `bridge.react(event)`, which animates the duck for live events (pat → squish, slouch → head shake, sign → speech bubble, sound → mic ripples, sentry → red lens).
- Interaction: drag to spin and tilt (up to a top view); click a part or label to zoom in; click the head to make the real duck quack; Esc or a click on empty space zooms back out.
- Theme is dark-only (the duck is the light source). Respects `prefers-reduced-motion`.
- Dependency: `three` (no react-three-fiber).
- **Personality outfit** (`components/duck/accessories.js`): `settings.coach_tone` dresses the duck. Gentle = plain, Coach = red cap (open crown so the touch ring shows) + whistle on a lanyard, Savage = gold-rimmed aviators (see-through enough that the camera lens reads). Cap + shades ride on `duck.neck`, the lanyard on the body under `squash`. `DuckContext.tone` ('gentle' on every route change until the dashboard loads settings); the stage pops the old piece off (150 ms), springs the new one on (450 ms) and hops. Coach `focus_start` → `react({type:'whistle'})` puffs the whistle; the savage lenses glint every 6 s. The landing's personality switch previews it.

## Landing page (`/welcome`) — scroll-driven duck
Logged-out visitors land here (`app/page.js` redirects to `/welcome`, not `/login`). Laptop only; the narrow-screen rules exist but aren't designed for.
- Files: `app/welcome/page.js` → `components/Landing.js`; styles under `/* ── landing (/welcome)` in `app/globals.css`.
- The page is one scroll container (`main.landing`, absolutely positioned over the fixed stage). Each `<section data-section="…">` is ≥100vh. The section crossing the middle of the screen is `active`, and `SECTIONS[active].stage` sets the duck:
  | Section | Stage | Duck reaction on first arrival |
  |---|---|---|
  | hero | close-up (`setStage(null)`, path → hero mode, follows cursor, winks) | “Hiii 👋” after 1.5 s |
  | overview | `dashboard` mode, no focus: whole duck + live labels; clicking a label scrolls to that part | spin on entry |
  | camera | focus `camera` | slouch head-shake, “Sit up straight 😤” |
  | petting | focus `petting` (top view) | squish + Quack |
  | voice | focus `voice` | says the picked tone line |
  | microphone | focus `microphone` | mic ripples, “🔔 Doorbell” |
  | focus | focus `focus` (back, NFC tag) | hop, “Focus mode 🎯” |
  | signs | focus `camera` | “Hello!” bubble, beak talks |
  | nest | focus `aside` (whole duck shifted left, no labels) | “Noted 🧠” |
  | end | close-up | “Adopt me 🥺” |
- Reactions fire 700 ms after arriving (after the camera flight) and only once per visit.
- **Continuous scroll motion** (`bridge.current.scroll = { p, v }`, written by Landing, read by DuckStage’s render loop):
  - `p` = progress through the active section (−0.5…0.5): adds up to ±0.35 rad of yaw and a little pitch, so the duck keeps turning while you scroll inside a section.
  - `v` = scroll velocity (px, decays with `exp(-6·dt)`): the duck leans into the scroll (`bob.rotation.x/z`, clamped) and splashes the water when you scroll fast (rate-limited to one splash per 0.45 s).
  - Off under `prefers-reduced-motion`. Landing clears `bridge.current.scroll` on unmount so the dashboard is unaffected.
- Copy choreography (CSS): each section’s column rises in once (`.sec.in`, staggered 80 ms), headlines drift against the scroll (`translate: 0 calc(var(--p) * -60px)`), demo blocks drift the other way (+40px). `--p` is set per section by the same scroll handler.
- Hero: eyebrow, `.mega` headline “Sit up straight / bestie.” (yellow word + beak-orange underline swipe), lede, one primary CTA + text link, and a bottom **event ticker** of the real event types (posture, pat, sign, sound, memory, coach, calendar, presence, sentry).
- Interactive bits: personality switch (Gentle / Coach / Savage, the duck says each line), LED pattern tiles that actually blink in each sound’s pattern, ASL gloss demo cycling real phrases from `pi/asl/phrases.json`, a “hey duck” Nest chat, event-log style readouts.
- Header: brand, a part nav (hidden on hero/end, highlights the active part), scene picker, Log in.

## First-visit tour (`components/Tour.js`)
- 5 steps: the duck (drag/quack) → the Camera label → the dock → the status pill → “Talk to it”. Spotlight follows its target every frame (labels sway). Card sits beside the target, or above the dock when there’s no target.
- Opens 1.8 s after login on first visit (`localStorage['duck-tour-v1']`), replays from the **?** button in the top bar. Keyboard: → / Enter next, ← back, Esc skip. The floating hint hides while it runs. Each step can trigger a duck reaction.

## Stage API additions (`DuckContext` / `DuckStage`)
- `setStage(mode|null)` overrides the route’s mode (used by the landing page); reset on every route change.
- Focus ids `activity`, `calendar`, `nest` and `aside` shift the duck left (clear of the panel) and hide its labels. Adding `nest` fixed labels showing through the Nest drawer.
- `bridge.current.scroll` (see above).

## UI audit (Oct 25) — open items
1. Demo with the duck online (or `./dev.sh --prod --fake-duck`) so the pill isn’t red.

Done (Oct 25):
- Hotspot labels and leader lines hide at once while any drawer is open (`.duck-overlay.drawer-open`).
- `a.btn` inherits colour (“Open Google Calendar” no longer blue). Disabled `.btn.primary` is an outline.
- ASL captions above the dock for 6 s per `sign` event (`.caption` in `app/page.js`). Camera drawer order: Live view → Sign card → tiles → chart.
- Water feathers into the panorama from 60 to 900 units out (`water.js`).
- Slouch chart drawn at 380×150, so axis text is ~11px.
- Recall: Claude ends with `NOTES: 3, 7`; `answerRecall` returns `{ text, sources }` (note ids) and the relay sends `sources` on the `memory` recall event. Nest flashes those notes for 2 min and groups notes under day headers.
- The scene’s jpg shows blurred behind the transparent canvas (`.duck-backdrop`) until the HDR loads; `app/layout.js` preloads `pool_2k.hdr`.
- Brand mark `components/BrandMark.js` + `app/icon.svg` favicon (a rubber duck, not 🦆). Settings controls show skeleton bars while the row loads.
- The greeting uses `user_metadata.display_name` right away.

## Decisions log (cont.)
- 2026-10-25: Keep the 3D duck as the navigation; no bento rebuild. Laptop-only for judging.
- 2026-10-25: Logged-out `/` goes to the `/welcome` landing page; the landing reuses the persistent stage instead of a separate hero.

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
