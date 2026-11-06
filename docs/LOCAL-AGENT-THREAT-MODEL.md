# Local agent: trust boundaries and current threat model

## Trust boundaries

1. Owner-controlled configuration grants a finite list of canonical filesystem roots.
2. The Rust agent reads metadata under those roots and writes an SQLCipher-encrypted local evidence ledger.
3. A separate owner-controlled source policy enables Windows foreground-window titles or manually pinned context notes.
4. In desktop mode, the agent runs as a managed worker thread inside the Tauri process.
5. The React UI invokes a finite Tauri command set. Dashboard commands are restricted to the main window; the avatar capability is limited to its own bounds and drag state.
6. The dashboard event stream uses a random session token, 30-minute expiry, bounded reads and explicit cursor acknowledgements. There is no unauthenticated localhost TCP listener.
7. The optional reasoner receives bounded evidence and owner-pinned context. It is disabled by default.
8. Model output is untrusted, parsed as strict JSON and validated against the supplied event IDs and finite action registry.
9. Native task execution exposes only typed capabilities; model output cannot add capabilities or expand permission scopes.

## Invariants

- No file-content reads, symlink traversal, keystrokes, clipboard, screenshots, audio capture, browser history or private application databases.
- No implicit home-directory or drive-wide enrollment.
- Foreground window titles are Windows-only, disabled by default and require separate owner consent. Titles may contain sensitive document or conversation names.
- Owner-pinned context is explicitly authored, bounded, encrypted, removable and never represented as observed activity.
- No reasoner by default and no remote metadata egress without HTTPS and explicit consent.
- API key values are not stored in the Rust agent config. Desktop provider secrets use the OS credential vault; Gemini API keys are sent in a request header, not a URL query string.
- SQLCipher protects the desktop and Android metadata databases at rest. Desktop database keys are stored in the OS credential vault; Android keys are wrapped by Android Keystore AES-256-GCM. iOS snapshot/event files use complete file protection and folder bookmarks use Keychain.
- No unsupported event ID can be cited by a model decision.
- No arbitrary shell, script, process launch, network, delete, move or overwrite capability.
- Metadata timestamps are not treated as proof of human activity.
- No claim of complete historical reconstruction.
- Avatar hit-testing uses transient cursor coordinates only; they are not stored or sent to the reasoner.

## Event stream semantics

The local dashboard stream has one active session per desktop process. Tokens expire after 30 minutes. A page is bounded to 100 records and remains repeatable until its final sequence is acknowledged. The server accepts only the last acknowledged cursor for the next read and only the final sequence of the issued page for acknowledgement. Renderer retries deduplicate by sequence. Retention gaps are surfaced; reconnecting at the current cursor intentionally abandons expired history. This is local IPC, not cross-device authentication.

## Typed action boundary

The initial capability registry contains only create_note:
- target root selected by an integer index into the separate approved note-output root list;
- root must be a canonical existing subfolder of an owner-authorized metadata root;
- filename is a short ASCII slug ending in .md, with no separators or nested paths;
- body is limited to 8192 bytes and rejects NUL;
- creation uses an exclusive temporary file and atomic hard-link to the destination; an existing target is never overwritten;
- pending approvals expire after 24 hours, are claimed once and have append-only transition audit records;
- revoking a note-output permission expires outstanding proposals;
- interrupted executions are marked uncertain/failed on restart and are not automatically retried.

Manual mode is the default. The owner reviews the exact path and content before approving a proposal.

A separate automatic policy can be enabled only after a note-output root has been separately authorized. It can execute only create_note, is hard-capped at three successful operations per UTC day, and leaves proposals pending when the quota is exhausted. The model cannot enable or modify this policy.

## Failure modes

- Root unavailable or permissions revoked: configuration validation fails closed.
- Directory entry inaccessible: scan reports incomplete inventory.
- Watcher error or bounded queue overflow: coverage gaps are persisted; reconciliation runs but missed event details cannot be recovered.
- Reasoner unavailable or malformed output: no decision is recorded and no action is executed.
- Remote endpoint configured without HTTPS or consent: configuration is rejected.
- Model cites event IDs absent from the request: decision is rejected.
- Action payload has an invalid root, filename or body: execution is rejected.
- Destination already exists: exclusive creation fails; no overwrite fallback exists.
- Action proposal is stale, expired, rejected or already claimed: the store refuses a second claim.
- Event token is invalid/expired or cursor is stale: IPC read is rejected; retained-history gaps are explicit.
- Database key is missing or incorrect: encrypted store fails closed rather than creating a replacement key.
- Permission revoke or policy change: worker is stopped and joined before the new configuration is reloaded.

## Known limitations

Filesystem notifications are not a universal audit log. They can be coalesced, missed, unsupported on some filesystems or unavailable due to OS permissions. Metadata scans observe current files, not deleted historical files. Android and iOS metadata ledgers remain local to each device; authenticated device pairing and sync are not implemented. iOS refresh is opportunistic, not continuous. Windows overlay interaction still needs physical multi-monitor, DPI, pointer and sleep/resume testing. Signed distribution requires owner-held signing credentials.
