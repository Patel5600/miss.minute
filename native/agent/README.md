# Miss Minutes native local agent

This is the first real native component of Miss Minutes. It runs as a process independent of the React/browser interface, so closing a browser tab does not stop the agent process.

## Current scope (truthful)

Implemented:

- Owner-confirmed, explicit directory allowlists.
- Initial recursive inventory of regular files in those roots.
- Cross-platform file-system notifications through the Rust notify crate.
- Periodic metadata reconciliation.
- Local SQLite event ledger with event IDs, observation timestamps, source timestamps and provenance labels.
- Retention pruning for events and decisions.
- Local reasoning through an OpenAI-compatible endpoint (for example, local Ollama).
- Evidence-ID validation for model decisions.
- Action proposals always require owner approval; no action executor exists.
- Permanent local-history deletion command.

Not implemented yet:

- Native system-tray character or desktop overlay.
- Automatic login startup/service installation.
- Screen reading, active-window tracking, keyboard/clipboard capture, notifications, browser history, email or application-private databases.
- File-content indexing.
- Cross-device sync or cloud task execution.
- Automatic execution of model-proposed actions.
- A browser-to-agent IPC/API bridge.

The UI can be closed while the separately launched native process continues. The visible animated character cannot appear over other applications until the desktop shell and tray/overlay renderer are implemented.

## Privacy contract

The agent only accesses directory roots explicitly added with init.

It reads filesystem metadata (path, size, regular-file status and filesystem modification time). It never opens a file to read its contents. It does not capture keystrokes, clipboard contents, screenshots, audio or private application data. Symlinks are not followed.

The filesystem modification timestamp is not a creation timestamp and is not proof that a human performed an action. Watcher notifications mean the operating system delivered a filesystem event to the process; they do not prove that the owner opened or edited a file.

The collector reports inaccessible entries, watcher failures and queue-overflow coverage gaps. It does not promise complete historical reconstruction. Historical inventory only shows files that exist and are accessible when the scan runs.

The SQLite event store is local but is not encrypted at rest in this milestone. The database contains file paths and metadata, so protect the device account and database directory. API keys are read from environment variables and never written to the config file.

## Build

Install the Rust stable toolchain (Rust 2024 edition; workspace MSRV 1.89):

    cargo test --workspace
    cargo build --release -p miss-minute-agent

## Initial enrollment

Review every directory before granting access:

    miss-minute-agent init --config ./miss-minute-agent.json --allow-root ./Projects --allow-root ./Documents --confirm-owner-permission

The command rejects filesystem roots and overlapping allowlisted directories. It does not silently add home directories or drives.

## Collect independently of the UI

    miss-minute-agent run --config ./miss-minute-agent.json

This process remains active when the browser UI closes. Stop it with Ctrl+C or the platform termination signal. A future desktop shell must launch and supervise this process in the background and provide a visible tray/quit control. This release does not yet install a startup service.

## Inspect collected evidence

    miss-minute-agent status --config ./miss-minute-agent.json
    miss-minute-agent recent --config ./miss-minute-agent.json --limit 50
    miss-minute-agent scan --config ./miss-minute-agent.json

## Enable local reasoning

For a locally running OpenAI-compatible server (for example, Ollama), configure its chat-completions endpoint and a model already installed on that server:

    miss-minute-agent configure-reasoner --config ./miss-minute-agent.json --endpoint http://127.0.0.1:11434/v1/chat/completions --model YOUR_INSTALLED_MODEL

The model must already be installed and the local server must already be running. No model is bundled.

For a remote HTTPS endpoint, supply api-key-env with an environment-variable name and explicitly add confirm-remote-metadata-egress. The agent sends local file paths and metadata to that remote endpoint. It never sends file contents. The API key value is read from the named environment variable and is not saved in JSON.

Inspect decisions:

    miss-minute-agent think --config ./miss-minute-agent.json
    miss-minute-agent decisions --config ./miss-minute-agent.json

A model may decide to remain silent. A speak decision is stored as a candidate for the future desktop UI; this command-line milestone does not synthesize speech. A proposed action is only a proposal and cannot execute.

## Delete local history

    miss-minute-agent forget-history --config ./miss-minute-agent.json --confirm-permanent-deletion

This deletes the event history, current file metadata index and stored decisions. It retains the configuration and authorized roots.
