# Local agent: trust boundaries and current threat model

## Trust boundaries

1. Owner-controlled configuration grants a finite list of directory roots.
2. The Rust agent reads metadata under those roots and writes an event ledger on the same device. In Tauri desktop mode, it runs as a managed worker thread inside the desktop process.
3. The React UI calls a finite set of registered Tauri commands and receives avatar events through Tauri IPC. There is no unauthenticated localhost TCP listener and no command that accepts shell text.
4. The optional reasoner receives only a bounded batch of event metadata.
5. A local reasoner endpoint is loopback-only for plaintext HTTP.
6. A remote reasoner endpoint requires HTTPS and explicit metadata-egress consent.
7. Model output is untrusted. It is parsed as a strict JSON decision and checked against the evidence IDs supplied to the model.
8. A model-generated action is a proposal only. This milestone has no command, shell or application-action executor.

## Invariants

- No file-content reads.
- No symlink traversal.
- No implicit home-directory or drive-wide enrollment.
- No reasoner by default.
- No remote metadata egress without explicit consent.
- No API key values stored in the native agent JSON configuration.
- No unsupported event ID can be cited by a model decision.
- No action proposal can omit owner approval.
- No arbitrary shell-command execution.
- No claim of full historical coverage.
- The database is local, but not encrypted at rest in this milestone.
- Avatar hit-testing uses transient cursor coordinates only; they are not stored in the evidence ledger or sent to the reasoner.

## Failure modes

- Root unavailable or permissions revoked: configuration validation fails closed.
- Directory entry inaccessible: scan reports an incomplete inventory.
- Watcher error: error is persisted as an observed collector event.
- Bounded watcher queue overflow: a coverage-gap event is recorded and metadata reconciliation runs; missed event details cannot be recovered.
- Reasoner unavailable or malformed output: no decision is recorded and no action is executed.
- Remote endpoint configured without HTTPS or consent: configuration is rejected.
- Model cites event IDs absent from the request: decision is rejected.
- Process termination: SQLite WAL recovery is used on next open; the next scan reconciles metadata, but cannot reconstruct every missed event.
- Tauri IPC command failure: UI receives a command error; no shell fallback is attempted.

## Known limitations

Filesystem notifications are not a universal audit log. They can be coalesced, missed, unsupported on some filesystems, or unavailable due to OS permissions. Metadata scans observe current files, not deleted historical files. The agent therefore makes no claim to reconstruct all device activity from first boot.

The agent currently observes authorized filesystem metadata only. It does not see active windows, keystrokes, clipboard, screens, web sessions, messages, or application-private data. Mobile background agents and autonomous task execution are not included in this milestone.
