# Desktop companion architecture

## Runtime boundaries

    React dashboard / overlay
            |
            | Tauri invoke IPC (typed commands)
            v
    Tauri desktop host
      |             |
      |             +-- tray + login-start registration
      |
      +-- managed Rust agent worker
              |
              +-- explicit directory allowlists
              +-- filesystem metadata notifications
              +-- SQLite evidence ledger
              +-- optional local / approved remote reasoner

The WebView does not connect to a local TCP port. Native calls cross the Tauri IPC boundary and are registered in the host command handler. The browser cannot invoke arbitrary Rust functions or start a process by passing a shell string.

## Overlay movement

The existing SVG renderer owns motion. Its animation loop uses a monotonic animation timestamp and bounded frame delta. The renderer reports the current avatar rectangle to the host at 10 Hz.

On Windows, the host creates a transparent, always-on-top, desktop-sized window. A small native worker polls the global cursor position and compares it to the latest avatar rectangle. The window ignores cursor events outside that rectangle, allowing desktop clicks to reach the underlying application. Inside the rectangle, the WebView receives pointer input and the existing drag behavior moves the character.

The native cursor gate uses only pointer coordinates for hit-testing. Coordinates are not recorded or sent to the reasoner.

## Lifecycle

The dashboard's close event hides the window instead of terminating the process. Tray actions control dashboard visibility, avatar visibility, worker stop, and final exit. The agent worker receives an explicit atomic shutdown token and is joined during a stop or app exit.

Login startup is opt-in. The autostart plugin registers the desktop executable and passes a background argument so the dashboard remains hidden on login while the avatar/tray lifecycle is restored.

## Action execution is intentionally gated

The reasoner currently produces silent, speak, or propose-action decisions. Its proposal contains a free-form category and description, not an executable typed payload. Therefore this build cannot safely execute those proposals. The next phase must define a finite action enum, typed payload validation, capability scopes, per-action approval policy, durable queue, dry-run preview, idempotency keys, and append-only execution audit before enabling any autonomous operation.
