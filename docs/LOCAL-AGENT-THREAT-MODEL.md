# Local agent: trust boundaries and current threat model

## Trust boundaries

1. Owner-controlled configuration grants a finite list of directory roots.
2. The Rust agent reads filesystem metadata under those roots and writes a local SQLite evidence ledger.
3. In desktop mode, the agent runs as a managed worker thread inside the Tauri process.
4. The React UI invokes a finite set of registered Tauri commands. There is no unauthenticated localhost TCP listener and no command that accepts shell text.
5. The optional reasoner receives a bounded batch of filesystem metadata.
6. A local reasoner endpoint is loopback-only for plaintext HTTP. Remote endpoints require HTTPS and explicit metadata-egress consent.
7. Model output is untrusted, parsed as strict JSON and validated against the evidence IDs supplied in the request.
8. Native task execution is a finite typed capability. Model output cannot add capabilities or expand permission scopes.

## Invariants

- No file-content reads, symlink traversal, keystrokes, clipboard, screenshots, audio capture, browser history or private application databases.
- No implicit home-directory or drive-wide enrollment.
- No reasoner by default and no remote metadata egress without explicit consent.
- API key values are not stored in the Rust agent config.
- No unsupported event ID can be cited by a model decision.
- No arbitrary shell, script, process launch, network request, delete, move or overwrite capability.
- Metadata timestamps are not treated as proof of human activity.
- No claim of complete historical reconstruction.
- The database is local but not encrypted at rest in this milestone.
- Avatar hit-testing uses transient cursor coordinates only; they are not stored or sent to the reasoner.

## Typed action boundary

The initial capability registry contains only `create_note`:
- target root selected by an integer index into the separate approved note-output root list;
- root must be a canonical existing subfolder of an owner-authorized metadata root;
- filename is a short ASCII slug ending in `.md`, with no separators or nested paths;
- body is limited to 8192 bytes and rejects NUL;
- creation uses an exclusive temporary file and atomic hard-link to the destination; an existing target is never overwritten;
- pending approvals expire after 24 hours, are claimed once, and have append-only transition audit records;
- revoking a note-output permission expires outstanding proposals;
- interrupted executions are marked uncertain/failed on restart and are not automatically retried.

Manual mode is the default. The owner reviews the exact path and content before approving a proposal.

A separate automatic policy can be enabled only after a note-output root has been separately authorized. It can execute only `create_note`, is hard-capped at three successful operations per UTC day, and leaves proposals pending when the quota is exhausted. The model cannot enable or modify this policy. Policy changes stop and join the worker before restart so stale in-memory permissions are not retained.

This is bounded autonomous execution for one low-risk file-creation capability. It is not general-purpose autonomous computer use.

## Failure modes

- Root unavailable or permissions revoked: configuration validation fails closed.
- Directory entry inaccessible: scan reports incomplete inventory.
- Watcher error: error is persisted as an observed collector event.
- Bounded watcher queue overflow: a coverage-gap event is recorded and metadata reconciliation runs; missed event details cannot be recovered.
- Reasoner unavailable or malformed output: no decision is recorded and no action is executed.
- Remote endpoint configured without HTTPS or consent: configuration is rejected.
- Model cites event IDs absent from the request: decision is rejected.
- Action payload has an invalid root, filename or body: execution is rejected.
- Destination already exists: exclusive creation fails; no overwrite fallback exists.
- Action proposal is stale, expired, rejected or already claimed: the store refuses a second claim.
- Permission revoke or policy change: worker is stopped and joined, pending proposals are expired where applicable, and the new configuration is reloaded.
- Process termination during an action: action is marked failed/uncertain and not automatically retried.
- Tauri IPC command failure: UI receives an error; no shell fallback is attempted.

## Known limitations

Filesystem notifications are not a universal audit log. They can be coalesced, missed, unsupported on some filesystems, or unavailable due to OS permissions. Metadata scans observe current files, not deleted historical files. The agent therefore makes no claim to reconstruct all device activity from first boot.

The agent currently observes authorized filesystem metadata only. It does not see active windows, browser sessions, notifications, messages, screen contents, or application-private data. Android/iOS native agents are not included. Precise click-through hit-testing is Windows-only in this milestone.

The SQLite database is not encrypted at rest, and provider credentials used by the web UI remain in browser local storage. OS credential-vault migration, signed installers, update verification, and a complete multi-platform security review remain future work.
