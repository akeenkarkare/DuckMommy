# Duck Daddy

A desk-companion duck for focus and posture. A Raspberry Pi inside the duck watches your posture with OpenCV, tells you out loud to sit up, guards your desk in sentry mode, quacks when you pat its head, and uses an NFC tag to trigger iOS focus/app-blocking. Every metric goes to a server, and a dashboard shows each logged-in user only their own data.

## Golden rules for Claude
1. **Hardcode before AI.** Use OpenCV or simple logic wherever it works. Do not add LLM or vision-API calls unless a task explicitly asks for one.
2. **Per-user isolation is non-negotiable.** Every DB query filters by the `user_id` from the authenticated session. Never take it from the request body or query params.
3. **Never commit secrets.** API keys and DB URIs live in `.env` only. `.env` is gitignored, and `.env.example` lists the variable names.
4. **Ask before adding a dependency.** This is especially important on the Pi, because installs there are slow and can break the camera stack.
5. **Video stays on the Pi.** The Pi sends events and metrics to the server, never the raw camera feed.
6. **If something below is marked TODO, ask; don't invent an answer.**

## Hardware (all inside the duck, always plugged into wall power)
| Part | Purpose | Connected to |
|---|---|---|
| Raspberry Pi 5 (8GB) | Main brain: OpenCV, audio, server uplink | — |
| Pi camera (wide-angle, night vision) | Posture + person detection | Pi CSI port |
| Ultrasonic sensor | Motion/presence for sentry mode |
| Touch sensor | Head pat → quack. Sensor sits under the shell, with a conductive wire up through the top |
| Speakers | Voice prompts + quack |
| USB microphone | Voice commands |
| NFC sticker | Phone tap → iOS Shortcut (no reader hardware; it's a passive tag) | On beak/back |

## Features — scope
**In scope (demo-critical, in priority order):**
1. **Posture detection.** OpenCV plus the pose library. When a slouch persists for N seconds, the duck plays a spoken prompt to sit up and logs a `posture` event.
2. **Pat to quack.** Touch triggers a quack sound and logs a `pat` event.
3. **Dashboard.** Login, then a posture-over-time graph for that user only. Start basic and add the duck theme last.
4. **NFC focus tag.** Tapping the tag opens iOS Shortcuts, where the user picks what to block (like a Brick device). Goal: judges should NOT have to build a Shortcut by hand.
5. **Sentry mode.** The ultrasonic sensor detects motion, then the camera confirms a person with OpenCV (works in night vision) and logs a `sentry` event.

**Out of scope until 1–5 work:**
- LLM object analysis ("show the duck a tool and ask what it does"). It needs an always-on API plus clip capture. If you build it later, make it on-demand only: a trigger captures a 5-second clip, which goes to the API.
- Showing the live OpenCV feed on the dashboard. The demo uses a person acting out slouching instead.

## Architecture
```
[Pi: camera/OpenCV, sensors, audio] <==WS + DUCK_TOKEN==> [Node relay] <==WS + Supabase session==> [Dashboard (Next.js)]
                                                                  |
                                                     [Supabase: Auth, profiles, settings]
```
- **Camera gating:** the camera feed is heavy, so the ultrasonic sensor decides when the camera turns on (someone is present → camera on; nobody → camera off). This applies to posture detection as well as sentry mode.
- **Live relay, no event storage:** the Pi streams events over a WebSocket to a Node relay process, which forwards them live to that user's dashboard. Events are not saved to a database.
- **The Pi owns reactions:** the Pi decides what to do (play a sound, speak a prompt) using settings the relay pushes to it. Dashboard settings changes and test commands go dashboard → relay → Pi.
- **Stack:** a Node WS relay plus the Next.js dashboard. Supabase handles Auth and the `profiles` and `settings` tables, all tied to the auth user with RLS. Schema: `/backend/supabase/schema.sql`.
- **Dashboard:** register and login pages, then the live event stream (with a 5-minute in-memory buffer on the relay, so it survives a refresh) and per-user settings (messages, volume, posture severity). Settings are saved to Supabase on change, and the relay pushes them to the Pi. See `/backend/CLAUDE.md` and `/dashboard/CLAUDE.md`.
- **Voice:** spoken messages are free text, read out by TTS on the Pi in the duck's own voice.
- **Network:** for the demo, the Pi is connected directly to the laptop running the relay.
- **One duck:** there is exactly one duck and no device management. The Pi authenticates to the relay with a shared `DUCK_TOKEN` from `.env`. The relay sends the duck's events to the **active user** and pushes that user's settings to the duck (see `/backend/CLAUDE.md`).
- **Event shape:**
  `{ user_id, type: "posture"|"pat"|"sentry"|"focus"|"presence", value, ts }`
  `presence` is the ultrasonic arrive/leave signal that turns the camera on or off. The `posture` payload is TBD until the posture code lands.
- The Pi reconnects automatically if the WebSocket drops and sends any events it queued in the meantime. Its reactions (quack, sit-up prompt) keep working with no connection. **The duck must keep working during the demo.**

## Repo layout
```
/pi         Python: camera, OpenCV posture, sensors, audio, uplink client
/backend    Node WS relay + Supabase schema
/dashboard  web frontend
/assets     sounds (quack, voice lines)
```
Each folder may get its own short CLAUDE.md with run/test commands. Keep this root file about the whole project.

## Commands (TODO: fill in as they exist)
- Pi: `TODO` (until then, `cd backend && npm run duck` simulates it)
- Camera preview (dev only): laptop `pi/camera/view.sh`, then Pi `pi/camera/stream.sh <laptop-ip>`. See `pi/camera/README.md`.
- Backend: `cd backend && npm run dev`
- Dashboard: `cd dashboard && npm run dev` → http://localhost:3000

## Definition of done for the demo
A judge sits down and slouches. Within a few seconds the duck speaks, and the slouch appears on that judge's dashboard graph. Patting the duck makes it quack. Tapping a phone on the beak opens the focus flow.