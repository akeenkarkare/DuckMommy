# Duck Daddy

A desk-companion duck for focus and posture. A Raspberry Pi inside the duck watches your posture with OpenCV, tells you out loud to sit up, guards your desk in sentry mode, quacks when you pat its head, and uses an NFC tag to trigger iOS focus/app-blocking. Every metric goes to a server, and a dashboard shows each logged-in user only their own data.

## Golden rules for Claude
1. **Hardcode before AI.** Use OpenCV or simple logic wherever it works. Do not add LLM or vision-API calls unless a task explicitly asks for one. The requested exceptions: **ElevenLabs** for the duck's voice, proxied by the relay (`POST /tts`), and **Claude (Anthropic API)** for the lock-in coach's lines, proxied by the relay (`POST /nudge`). Both keys stay on the laptop, and the Pi falls back to espeak / templates when they're unavailable. Local models (MediaPipe pose/holistic, YAMNet) are fine.
2. **Per-user isolation is non-negotiable.** Every DB query filters by the `user_id` from the authenticated session. Never take it from the request body or query params.
3. **Never commit secrets.** API keys and DB URIs live in `.env` only. `.env` is gitignored, and `.env.example` lists the variable names.
4. **Ask before adding a dependency.** This is especially important on the Pi, because installs there are slow and can break the camera stack.
5. **Video stays on the Pi, with one owner-approved exception.** The Pi sends events and metrics to the server, never a stored or always-on camera feed. The exception (Akeen, 2026-10-24) is the dashboard's opt-in **live view**: annotated JPEG frames go Pi → relay → dashboard over the authenticated sockets, only while a logged-in user the duck is with has it open (optionally restricted with `VIDEO_VIEWERS` in `backend/.env`), and are never stored. Keep it that way: no recording, no unauthenticated video endpoint on the server.
6. **If something below is marked TODO, ask; don't invent an answer.**

## Hardware (all inside the duck, always plugged into wall power)
| Part | Purpose | Connected to |
|---|---|---|
| Raspberry Pi 5 (8GB) | Main brain: OpenCV, audio, server uplink | — |
| Pi camera (wide-angle, night vision) | Posture + person detection | Pi CSI port |
| Ultrasonic sensor | Presence at the desk + sentry wake-up | GPIO `ULTRASONIC_TRIG/ECHO` (TODO: confirm pins) |
| Pressure sensor (digital out, e.g. FSR + comparator module) | Head press → quack | GPIO `PRESS_PIN` (TODO: confirm part + pin) |
| Alert LED | Flashes for doorbell / phone / alarm / notification / someone calling | GPIO `LED_PIN` (TODO: confirm pin) |
| Speakers | Voice prompts + quack |
| USB microphone | Sound alerts (doorbell, phone, alarms) | USB, `MIC_DEVICE` |
| NFC sticker | Phone tap → iOS Shortcut (no reader hardware; it's a passive tag) | On beak/back |

## Features — scope
**In scope (demo-critical, in priority order):**
1. **Posture detection.** OpenCV plus the pose library. When a slouch persists for N seconds, the duck plays a spoken prompt to sit up and logs a `posture` event.
2. **Press to quack.** The pressure sensor triggers a quack (`assets/quack.wav`, made with ElevenLabs sound effects) and logs a `pat` event.
3. **Dashboard.** Login, then a posture-over-time graph for that user only. Start basic and add the duck theme last.
4. **NFC focus tag.** Tapping the tag opens iOS Shortcuts, where the user picks what to block (like a Brick device). Goal: judges should NOT have to build a Shortcut by hand.
5. **Sentry mode.** The ultrasonic sensor detects motion, then the camera confirms a person with OpenCV (works in night vision) and logs a `sentry` event.
6. **Voice.** ElevenLabs in the duck's own voice; the dashboard sets what it says.
7. **Sign to Duck.** The user signs ASL word signs at the camera; the duck speaks the phrase (MediaPipe Holistic + DTW templates, no API) and logs a `sign` event. Code: `pi/asl`.
8. **Sound alerts.** The mic hears a doorbell, phone, alarm, notification or someone calling, flashes the LED in a pattern per sound, and logs a `sound` event.
9. **Lock-in coach (Tomo-style).** Persuasive spoken nudges: an arrival brief of what's due, deadline reminders (24 h / 3 h / 1 h / 15 min), event heads-ups, periodic check-ins, a "zoned out?" nudge after 5 min with no movement (then marked away after 5 more), and focus sessions from the START FOCUS sign or the dashboard. Logs `coach` events. Code: `pi/coach`, `pi/motion`.
10. **Talk to the duck** ("hey duck, …", Sara's memory locker + voice commands): remember / recall notes, "remind me in 5 days to…" (spoken when due), "what's on my calendar tomorrow?", "let's lock in". Replies in the ElevenLabs voice. Code: `pi/memory`, `backend/src/memory.js`.
11. **Calendar.** iCal feed links (Google Calendar secret address, Brightspace/Canvas) pasted on the dashboard; the relay fetches and parses them (`backend/src/ics.js`, no deps) and pushes the next week to the duck. The links never reach the Pi. Google sign-in is a possible later addition.

**Out of scope until 1–5 work:**
- LLM object analysis ("show the duck a tool and ask what it does"). It needs an always-on API plus clip capture. If you build it later, make it on-demand only: a trigger captures a 5-second clip, which goes to the API.
- ~~Showing the live OpenCV feed on the dashboard~~: done as the opt-in live view (see rule 5).

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
- **Network:** the relay + dashboard run on the **server 209.182.234.33** (`./dev.sh --prod`; site http://209.182.234.33:3000, relay ws://209.182.234.33:8080). The **Pi is 192.168.1.67** (`sbuhacks26`) and runs only `duck.py`, with `RELAY_URL=ws://209.182.234.33:8080` in `pi/.env`.
- **One duck:** there is exactly one duck and no device management. The Pi authenticates to the relay with a shared `DUCK_TOKEN` from `.env`. The relay sends the duck's events to the **active user** and pushes that user's settings to the duck (see `/backend/CLAUDE.md`).
- **Event shape:**
  `{ user_id, type: "posture"|"pat"|"sentry"|"focus"|"presence"|"sign"|"sound"|"coach", value, ts }`
  `presence` is the ultrasonic arrive/leave signal that turns the camera on or off. Payloads are listed in `/backend/CLAUDE.md`.
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
- Pi: `cd pi && python3 duck.py` (setup in `pi/README.md`; `cd backend && npm run duck` simulates it)
- Sign to Duck data + training: see `pi/asl/README.md` (`duck.py` loads the model).
- Sentry: `cd pi/sentry && python3 run.py --trig <BCM> --echo <BCM>` (or `--no-ultrasonic`). Night vision is automatic. See `pi/sentry/README.md`.
- Camera preview (dev only): laptop `pi/camera/view.sh`, then Pi `pi/camera/stream.sh <laptop-ip>`. See `pi/camera/README.md`.
- **Website (relay + dashboard together): `./dev.sh`** → http://localhost:3000 · `./dev.sh --fake-duck` adds the simulated duck (no Pi needed) · **on a server use `./dev.sh --prod`** (Next 16 dev mode won't hydrate for browsers opening it by IP/hostname)
- Backend: `cd backend && npm run dev` · tests: `npm test`
- Supabase: run each `backend/supabase/migrations/*.sql` once (003 coach + calendar, 004 Google Calendar, 004 memories, 005 voice reminders).
- Camera won't start: `cd pi && ./doctor.sh`
- Dashboard: `cd dashboard && npm run dev` → http://localhost:3000

## Definition of done for the demo
A judge sits down and slouches. Within a few seconds the duck speaks, and the slouch appears on that judge's dashboard graph. Patting the duck makes it quack. Tapping a phone on the beak opens the focus flow.