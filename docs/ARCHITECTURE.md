# Miss Minutes architecture

Miss Minutes runs as a web app (Vite + React 19) and as a Windows desktop app (Tauri 2) that
embeds the same UI. Everything she stores lives on this device.

```
assets/                     Owner's Miss Minutes reference art (gitignored, never committed)
public/mm/                  Processed copies + manifest.json made by `npm run assets` (gitignored)
src/
  types/index.ts            Shared types (Emotion, Gesture, AISettings, ChatMessage, ToolCallRecord…)
  store/db.ts, useDb.ts     IndexedDB: chats, messages, memories, schedule, todos, timers, notes, activity
  character/                The animated Miss Minutes rig, stage, archive gallery, cue bus
  agent/
    brain/                  Providers, streaming, orchestrator (tool loop + approvals), persona
    memory/                 Long-term memory store, extraction, retrieval
    tools/                  Tool registry and every tool (timers, schedule, weather, files…)
    realtime/               Live voice calls (OpenAI Realtime over WebRTC, Gemini Live)
    scheduler.ts            Fires timers, alarms and reminders
    context.ts              Per-turn facts for the model (time, agenda, timers)
  panels/                   Sacred Timeline (real schedule), Toolbelt, Dossier (memories), Activity
  services/voiceService.ts  Speech out (system, OpenAI, ElevenLabs, local) and speech in
  desktop/bridge.ts         Typed Tauri IPC contract
native/
  agent/                    Rust local agent (encrypted evidence ledger, typed note actions)
  desktop/src-tauri/        Tauri host: overlay, tray, provider proxy, sign-in, PC control, alarms
  voice/                    Private on-device voice engine (Chatterbox TTS, Whisper STT)
```

## Secrets

- **Desktop:** API keys and OAuth tokens live in the Windows Credential Manager (or an
  AES-GCM file whose key is in the vault). Provider requests go through the native proxy
  (`provider_http_stream`), which injects the credential. The WebView never sees a key.
- **Web:** keys are held in memory for the session. "Remember on this device" stores them
  encrypted with a non-extractable WebCrypto key. They are sent only to the chosen provider.
- **Pairing instead of keys:** "Continue with ChatGPT" (desktop, OpenAI's open-source sign-in
  with loopback PKCE) and OpenRouter pairing (PKCE; loopback or a one-time code to paste).

## Tool policy

Set by the owner: timers, alarms, reminders, schedule, to-dos, notes, clocks, weather,
searches and memory run on their own. Files, commands and PC control ask first and show
exactly what will happen; nothing runs until that exact preview is approved. Settings →
"Always ask first" makes every tool ask. Desktop actions are proposed to the host, which
stores the exact action; approval executes the stored action, not re-sent arguments.

## Tool table (model-facing names and arguments)

Arguments are snake_case JSON. Times are ISO 8601 in the owner's local time unless noted.

| Tool | Arguments | Policy |
|---|---|---|
| get_time | city?, timezone? (IANA) | auto |
| set_timer | duration_seconds (1–86400), label? | auto |
| list_timers | — | auto |
| control_timer | action: pause\|resume\|cancel\|add_time, id?, label?, seconds? | auto |
| set_alarm | time "HH:MM" (24h), label?, days?: once\|daily\|weekdays\|weekly | auto |
| add_reminder | title, at, recurrence?: none\|daily\|weekdays\|weekly\|monthly, notes? | auto |
| add_event | title, start, end?, location?, notes?, recurrence? | auto |
| list_schedule | from?, to?, kind?: event\|reminder\|alarm\|all | auto |
| update_schedule_item | id, title?, start?, end?, done?, snooze_minutes? | auto |
| delete_schedule_item | id | confirm |
| find_conflicts | date? (YYYY-MM-DD) | auto |
| add_todo | text, priority?: low\|normal\|high, due? | auto |
| list_todos | include_done? | auto |
| complete_todo | id? or text? | auto |
| delete_todo | id | confirm |
| create_note | title, body | auto |
| list_notes | query? | auto |
| read_note | id | auto |
| append_note | id, text | auto |
| delete_note | id | confirm |
| get_weather | city? (defaults to home city), days? (1–7) | auto |
| web_search | query, max_results? | auto |
| calculate | expression | auto |
| remember | fact, category? | auto |
| recall | query | auto |
| forget | id | confirm |
| look_at_screen | — (web: screen picker; desktop: capture) | confirm |
| look_through_camera | — | confirm |
| list_apps *(desktop)* | query? | auto |
| system_info *(desktop)* | — | auto |
| open_app *(desktop)* | name | confirm |
| open_url *(desktop)* | url (http/https) | confirm |
| open_path *(desktop)* | path | confirm |
| list_directory *(desktop)* | path | confirm |
| read_text_file *(desktop)* | path, max_bytes? | confirm |
| write_text_file *(desktop)* | path, content, mode: create\|overwrite\|append | confirm |
| make_directory *(desktop)* | path | confirm |
| move_path *(desktop)* | from, to | confirm |
| copy_path *(desktop)* | from, to | confirm |
| delete_path *(desktop)* | path (moved to the Recycle Bin) | confirm |
| run_command *(desktop)* | command (PowerShell), cwd?, timeout_seconds? | confirm |

Desktop paths may be absolute, `~\…`, or start with Desktop, Documents, Downloads, Pictures,
Music or Videos. The host resolves them and shows the full path in the preview.

## Desktop commands (Tauri IPC, dashboard window only unless noted)

| Command | Purpose |
|---|---|
| provider_http_stream(request, requestId, onEvent: Channel) | Provider request with injected credential; streams head/data/bytes/end/error |
| provider_http_cancel(requestId) | Abort a stream |
| provider_has_credential(provider) → bool | Whether a credential is stored (never returns it) |
| realtime_client_secret(provider, session) → JSON | Mint a short-lived realtime secret |
| chatgpt_sign_in / chatgpt_account / chatgpt_sign_out / chatgpt_models | Sign in with ChatGPT |
| openrouter_pair_start(mode: loopback\|code) / openrouter_pair_complete(code?) | OpenRouter pairing |
| desktop_propose(tool, args) → DesktopProposal | Validate + store an exact action, return preview |
| desktop_run(tool, args) | Read-only tools only (list_apps, system_info) |
| desktop_approve(id) / desktop_reject(id) / desktop_audit(limit) | Execute / discard / history |
| capture_screen → data URL | Screenshot after an explicit owner action |
| schedule_sync(alerts) | Native alarm clock (fires while the dashboard is hidden) |
| voice_* / avatar_speak / avatar_say (avatar window) | Speech routing and local voice engine |

## Character cues

The model starts every reply with a hidden tag, e.g. `[[mood=winking gesture=wave]]`.
The brain strips it from the visible text and emits a cue (`src/character/cues.ts`).
Moods: cheerful, talking, winking, suspicious, scary, thinking, pruning, blushing, stern,
surprised, sassy, worried. Gestures: none, wave, shrug, point, hips, present, think, knock, clap.
