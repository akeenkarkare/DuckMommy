# Backend — context

A Node process that runs alongside the Next.js app and works as a **live relay** between the duck and the dashboard. Events are **not stored** (the one exception: the memory locker's `memories` table). Root rules in `/CLAUDE.md` apply (per-user isolation, no secrets in git, ask before deps).

## Stack
- **Node process** (WebSocket server) connected to the **Next.js** dashboard app
- **Supabase**: Auth + `profiles` and `settings` tables. No event table.
- Demo setup: everything runs on a laptop connected to the duck.

## Responsibilities
1. **Accept the Pi's WebSocket**, authenticated with the shared `DUCK_TOKEN` (one duck, no device table).
2. **Accept dashboard WebSockets**, authenticated by the Supabase session → resolve `user_id`.
3. **Relay events** Pi → the **active user's** dashboard(s) only. Not stored in the DB.
4. **In-memory buffer:** keep the last **5 minutes** of events per user and send it to a dashboard when it connects.
5. **Push settings to the Pi** when it connects and whenever they change. The dashboard writes settings straight to Supabase, and the relay hears about it through Supabase Realtime on `settings`.
6. **Relay manual commands** dashboard → that user's Pi (e.g. "say it now").
7. **No reaction logic.** The Pi decides what to do (sounds, prompts) using the settings it was sent.

## Data flow
```
Pi  <==WS (DUCK_TOKEN)==>    Node relay  <==WS (Supabase session)==>  Dashboard (Next.js)
     events  ------------------------------------------------------>  live stream / graph
     settings, commands  <-------------------------------------------  settings page, test buttons
                                  |
                                  |                                            |
                                  +--> Supabase: settings (Realtime subscribe)  +--> Supabase: settings, profiles
                                                                     <--------------- (writes on change)
```
- The Pi is connected **directly to the laptop** running the relay.
- The relay uses the Supabase **service role key** (in `.env` only). The dashboard uses the anon key plus the user session.

## Auth / isolation
- **Pi:** shared `DUCK_TOKEN` from `.env`, checked on WS connect.
- **Active user:** the duck's events are tagged with the active user's `user_id` and sent only to that user. The active user's settings are pushed to the duck. The active user is **whoever most recently logged in or opened the dashboard**, and there's no claim button. When the active user changes, push the new user's settings to the duck. The 5-minute buffer is per user, so one judge never sees another's events.
- **Dashboard:** verify the Supabase JWT on WS connect and take `user_id` from it.
- Route messages only between connections with the same `user_id`. Never trust a `user_id` sent inside a message.

## Tables — see `supabase/schema.sql` (draft, under review)
- `profiles`: display name, created on register
- `settings`: volume, TTS messages, posture severity/delay (placeholder), sentry/quack toggles, created on register
- `memories`: things the user told the duck to remember (`text` = Claude's cleaned sentence, `heard` = raw transcript, `source`). The relay inserts; the dashboard reads/deletes its own rows (RLS).
- RLS on every table: `user_id = auth.uid()`

## Event shape
`{ user_id, type: "posture"|"pat"|"sentry"|"focus"|"presence", value, ts }`
- The relay sets `user_id` to the active user, never from the payload.
- `presence`: the ultrasonic sensor reports someone arriving or leaving, which turns the camera on or off.
- `posture`: payload TBD until the posture code exists. Don't design slouch judging or thresholds yet.

## Wire protocol (implemented in `src/relay.js`; the real Pi must match `sim/fake-duck.js`)
The first message on any socket is auth. Otherwise the socket is closed (4001 = no/late auth, 4003 = bad token/session).
- Duck → relay: `{type:"auth", role:"duck", token}`, then `{type:"event", event:{type, value, ts}}`
- Relay → duck: `{type:"auth_ok"}`, `{type:"settings", settings:{...}}`, `{type:"command", command:{type:"say", text} | {type:"quack"} | {type:"coach", name}}`, `{type:"agenda", items:[{id, title, kind:"due"|"event", start, end, all_day}]}` (ms epoch; next 7 days)
- Dashboard → relay: `{type:"auth", role:"dashboard", access_token}`, `{type:"settings_changed"}`, `{type:"command", command}`, `{type:"agenda_refresh"}`. Coach command names: `start_focus`, `break`, `finish`, `time_left`, `more_time`.
- Relay → dashboard: `{type:"auth_ok", user_id}`, `{type:"buffer", events}`, `{type:"event", event}`, `{type:"status", duck_connected, with_you}`, `{type:"command_ack", ok}`, `{type:"agenda", items, errors, feeds, fetched_at}` (that user's own calendars only; errors name the host, never the secret link)
- Fake `value` payloads (until the real sensors exist): posture `{state:"slouch"|"upright", neck_angle_deg, slouch_duration_s}`, pat `{touch_ms}`, presence `{present, distance_cm}`, sentry `{distance_cm, person_confirmed, confidence, night, trigger: ultrasonic|camera|arrive}` (real code: `pi/sentry/watch.py`; `arrive` = someone sat down while sentry was on, see `pi/duck.py`; presence then carries `sentry: true`), focus `{source:"nfc", action:"tap"}`, sign `{text, signs, commands}` (`pi/asl`), sound `{kind: doorbell|phone|alarm|notification|calling, label, score}` (`pi/sounds/alerts.py`), coach `{kind: arrival|deadline|event|checkin|idle|focus_start|focus_done|break_start|break_over|finish|more_time|time_left, text, source: ai|template, item, focus_minutes_left}` (`pi/coach`). presence may carry `reason: "idle"` (no movement for 10 min).
- **Voice / memory locker:** `POST /voice` with `Authorization: Bearer DUCK_TOKEN`, body `audio/wav` (or `application/json {text}` for testing). The relay transcribes with ElevenLabs Scribe, Claude (`MEMORY_MODEL`, default `ANTHROPIC_MODEL`, code in `src/memory.js`) picks the intent and cleans up the words:
  - `remember` → insert into `memories`; `recall` → answer from `memories`.
  - `remind` ("remind me in 5 days to…") → Claude gives the reminder text + local `YYYY-MM-DDTHH:MM` (from the current time in `TZ`/`MEMORY_TZ`), the relay validates it (`parseRemindAt`, future, ≤ 1 year), inserts into `reminders` and confirms with a deterministic time phrase (`friendlyWhen`). A 15 s ticker says due reminders to the active user's duck ("Hey Akeen, time to…"), only while the duck reports someone at the desk (else it waits; > 10 min late → "earlier you asked me to remind you to…"), claiming each row (`delivered_at`) before speaking so it's said once.
  - `agenda` ("what's on my calendar tomorrow?") → Claude answers from the user's cached agenda (iCal + Google) plus pending reminders, never inventing.
  - `focus` ("let's lock in", "taking a break", "how much time is left") → `command {type:"coach", name}` to the duck; reply has `quiet: true` so the Pi doesn't speak over the coach.
  - `sentry` ("hey duck, sentry mode on/off") → updates `settings.sentry_enabled` for that user, pushes it to the duck, and sends that user's dashboards `{type:"settings_patch", settings}` so the toggle follows.
  - `lookup` ("what's the weather", "who won the Mets game", "is Target open") → the duck first says "Hold up, let me look that up" (`command say` with `now: true`, so it isn't held back during the turn), then `answerLookup` asks Claude with the **web search** tool (`web_search_20250305`, at most 2 searches, ~$0.01 each; `user_location` from `DUCK_PLACE`, default Stony Brook, New York) and speaks the text after the last search result.
  - `other` (small talk, "how are you") → Claude's `reply` from the same understand call, Gen Z, never inventing facts.
  - Claude ignores whatever was said before the (often misheard: "hey doc") wake phrase.
  - A remind with no time / no text asks back ("okay but when should I remind you to…?") with `listen: true`: the Pi records the answer without the wake word, and the relay reads it together with the first request (`voiceFollowUps`, 30 s).
  Returns `{ say, intent, heard, memory?, focus?, quiet?, listen? }`; the duck speaks `say` unless `quiet`. Emits `memory` events `{action: saved|recall|reminder_set|reminder_due|agenda|lookup, ...}` to the dashboard. Tables: `memories` (migration 004_memories), `reminders` (migration 005).
- **TTS proxy:** `POST /tts {text}` with `Authorization: Bearer DUCK_TOKEN` returns raw 16-bit mono PCM @ 22050 Hz from ElevenLabs (`ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, optional `ELEVENLABS_MODEL_ID` in `.env`). `/health` shows `tts: true` once configured. `npm run make-quack` makes `assets/quack.wav`.
- **Coach lines:** `POST /nudge {kind, tone, facts}` with `Authorization: Bearer DUCK_TOKEN` returns `{text}` from Claude (`ANTHROPIC_API_KEY`, optional `ANTHROPIC_MODEL` default `claude-haiku-5-5`, optional `ANTHROPIC_BASE_URL`). 503 when not configured, so the Pi uses its templates. Prompt: `src/nudge.js`. `/health` shows `coach_ai: true` once configured.
- **Live view (camera):** dashboard → relay `{type:"video", on}`; relay → dashboard `{type:"video_status", streaming, reason, fps}`; relay → duck `{type:"video", on, fps}` only while at least one watcher exists; duck → relay **binary** WS messages = one JPEG each, forwarded only to the active user's watching dashboards (any logged-in user by default; `VIDEO_VIEWERS` = comma list of emails restricts it, `off` disables it). Frames are dropped for a watcher more than 1 MB behind and are never stored or buffered. `VIDEO_FPS` (1-15, default 6). `/health` shows `live_view`, `watching`.
- **Calendar:** `settings.calendar_urls` (one iCal link per line) is read only by the relay (`src/calendar.js`, `src/ics.js`), refreshed every 10 min and when the links change, and is NOT in the settings pushed to the Pi.
- Settings reach the duck by two paths: Supabase Realtime and the dashboard's `settings_changed` ping. Duplicate pushes are harmless.

## Settings (per user, edited on the dashboard)
- Messages/voice clips per event type
- Volume
- Posture severity: placeholder until the posture code exists
- More as needed

## Dependencies (approved)
- `ws` (WebSocket server), `@supabase/supabase-js` (token lookup, JWT check, Realtime)

## Open questions
None right now.

## Commands
- Install: `npm install` (in `/backend`)
- Relay: `npm run dev` (auto-restarts on change) or `npm run relay` · health check: `curl 209.182.234.33:8080/health`
- Fake duck: `npm run duck` (realistic pacing) or `npm run duck:fast` (4× speed)
- Test: `npm test` (node's built-in runner: iCal parsing/recurrence/DST, agenda merge, nudge prompt + cleanup)

## Decisions log
- 2026-10-23: Stack is Next.js + Supabase (Auth + tables).
- 2026-10-23: `presence` added to the event types (Akeen signed off).
- 2026-10-23: Slouch judging is deferred until the posture code lands.
- 2026-10-23: The backend is a Node WS process connected to Next. Events are relayed live and **not stored**. The Pi owns reaction logic (this replaces the earlier "server decides actions"). The remaining tables are tied to the Supabase auth user with RLS.
- 2026-10-23: Settings are written by the Next.js dashboard to Supabase. The relay subscribes via Realtime and pushes them to the Pi. An in-memory event buffer is approved. Deps are approved. The Pi is connected directly to the laptop.
- 2026-10-23: Only one duck, so the `devices` table is dropped and the Pi uses a shared `DUCK_TOKEN`. The buffer is 5 minutes.
- 2026-10-23: The active user is whoever most recently logged in or opened the dashboard (no claim button).
- 2026-10-24: Live camera view on the dashboard (Akeen asked; exception to root rule 5). Allowlisted accounts only, opt-in per viewing, relay-forwarded, never stored.
- 2026-10-24: Lock-in coach + calendar (Akeen asked for it, Tomo-style). Claude writes the lines via `/nudge` (key on the laptop), templates as fallback. Calendar = iCal feed links parsed in-house (no new dependency); Google sign-in maybe later. New settings columns in `migrations/003_coach_and_calendar.sql`.
- 2026-10-25: Look things up by voice (Akeen asked, replacing a weather-only Open-Meteo version): Claude's web search server tool, no new dependency.
- 2026-10-25: The duck talks Gen Z (Akeen asked): `GENZ_STYLE` in `src/nudge.js` goes into every Claude prompt the duck speaks from (coach, recall, calendar); fixed lines and the Pi templates are rewritten to match.
- 2026-10-25: Voice reminders + calendar/focus by voice (Akeen asked): `remind` / `agenda` / `focus` intents on `/voice`, `reminders` table (migration 005), delivered by the relay when due and you're at the desk.
- 2026-10-25: Memory locker ("Nest"). sara asked for it. `memories` table stores only Claude's cleaned-up sentence (no audio, no raw transcript), RLS per user, deletable from the dashboard. Speech goes to ElevenLabs (STT) and Claude via `/voice`.

## Google Calendar (via Auth0)
The Calendar tab's **Connect Google Calendar** goes through Auth0's Google login. The relay then reads **every calendar in the user's Google list** (titles and times only, the next 7 days) into the same agenda as the iCal links.
- **Reminders** (`src/reminders.js`): for every timed event the duck says *"In 5 minutes: X."* and *"X is starting now."*, and the dashboard shows the same line (`calendar` event, speech bubble). Plain sentences, no AI. The Pi coach no longer gives its own 15-minute event heads-up; it still handles deadlines (3 h / 1 h / 15 min).
- **Read my day** (`say_agenda`): today's remaining items, spoken by the duck.
- Clicking an item opens it in calendar.google.com.
- Code: `src/google.js` (Auth0 + Google Calendar API, plain fetch), relay messages `google_connect` / `google_disconnect` / `say_agenda`, callback `GET /auth/google/callback`. Only the Auth0 user id is stored (`google_calendar` table, migration 004); the Google tokens stay in Auth0.

### One-time setup
1. **Google Cloud** (console.cloud.google.com): create a project → enable the **Google Calendar API** → OAuth consent screen (External; add your Gmail under *Test users*; scope `.../auth/calendar.readonly`) → Credentials → **OAuth client ID** (Web application). Authorized redirect URI: `https://<AUTH0_DOMAIN>/login/callback`. Copy the client ID and secret.
2. **Auth0** (manage.auth0.com):
   - Authentication → Social → **Google / Gmail**: paste the Google client ID and secret, tick **Offline Access** (and Calendar if it's listed). Save.
   - Applications → **Create application** → Regular Web Application. Settings: **Allowed Callback URLs** = `http://209.182.234.33:8080/auth/google/callback`. Connections tab: enable **google-oauth2**.
   - Applications → APIs → **Auth0 Management API** → Machine to Machine Applications → authorize the same app with **read:users** and **read:user_idp_tokens**.
3. **backend/.env**: `AUTH0_DOMAIN` (e.g. `duckdaddy.us.auth0.com`), `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `RELAY_PUBLIC_URL=http://209.182.234.33:8080` and `DASHBOARD_URL=http://209.182.234.33:3000`. Restart the relay; `/health` shows `google_calendar: true`.
4. **Supabase**: run `supabase/migrations/004_google_calendar.sql` (and `003_coach_and_calendar.sql` if it hasn't been run yet).

While the Google consent screen is in *Testing* mode, Google expires refresh tokens after 7 days: just press Connect again (or publish the app).


## Phone alerts (sentry → ntfy push)
- A `sentry` event with `person_confirmed: true` (the Pi's sentry check, or someone sitting down while sentry is on) → `src/notify.js` POSTs to `https://ntfy.sh/$NTFY_TOPIC`: *"There's a person in your room. Seen at 3:42 AM."* (`(lights are off)` at night). Install the **ntfy** app and subscribe to the same topic.
- Fire and forget from `handleDuck`, every error caught and logged (`phone alert sent / failed`). **No-op unless `NTFY_TOPIC` is set.** The Pi's sentry cooldown (60 s) already limits it to about one push a minute.
- Only while the duck has an active user (someone opened the dashboard); with no owner, events are dropped and nothing is sent.
- Env: `NTFY_TOPIC` (hard to guess: anyone who knows it can read the alerts; `echo duckmommy-$(openssl rand -hex 4)`), optional `NTFY_URL` (self-hosted), `ALERT_TZ` (default America/New_York). Test: `curl -d "test from duck" ntfy.sh/<topic>`.
