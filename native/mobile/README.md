# Mobile companion targets

These are deliberately separate native companions. They do not pretend that iOS and Android have desktop-equivalent background privileges.

## Android

Build from `native/mobile/android` with Gradle 8.10.2, JDK 17 and Android SDK 35:

```sh
gradle --no-daemon :app:assembleDebug
```

The first release slice contains:

- A foreground service started only by an explicit owner action.
- Android's `specialUse` foreground-service declaration and an ongoing notification with a Stop action.
- A persisted Storage Access Framework grant for exactly one owner-selected document tree.
- Bounded recursive metadata enumeration (5,000 documents per pass, depth 16), no file-content reads and no cross-app screen/clipboard/audio/key input.
- A SQLCipher-encrypted local snapshot/event ledger, bounded to 10,000 events. Its random 256-bit database key is wrapped with AES-256-GCM under a non-exportable Android Keystore key.
- A 60-second reconciliation loop while the foreground session remains enabled.

Android may still stop the process under system pressure. `START_STICKY` is a restart request, not a service-liveness guarantee. Special-use foreground service classification and its Play policy declaration require review before public distribution. The database key envelope is stored in app-private preferences, and Android backup is disabled so the device-bound Keystore key and encrypted database are not restored separately. If a database exists without its key envelope, the service fails closed rather than silently opening it as plaintext or creating an empty history. An older development database requires explicit export/removal before encrypted storage can initialize. No desktop pairing or network synchronization protocol is wired yet.

## iOS

The XcodeGen project is in `native/mobile/ios`. Build a simulator target with XcodeGen and Xcode:

```sh
cd native/mobile/ios
xcodegen generate --spec project.yml
xcodebuild -project MissMinutesCompanion.xcodeproj -scheme MissMinutesCompanion -sdk iphonesimulator -configuration Debug CODE_SIGNING_ALLOWED=NO build
```

The owner chooses a folder through the document importer. A security-scoped bookmark is stored in Keychain. Background refresh inspects metadata only, writes an app-container snapshot protected by iOS data protection, and schedules the next opportunistic refresh. iOS decides whether and when a refresh runs; it is not a daemon and cannot present a floating avatar over other apps. The selected folder permission can become stale and then requires owner re-selection. Snapshot and event files use iOS complete file protection; the folder bookmark is stored in Keychain.

## Shared limitation

Neither mobile target currently pairs to the desktop or shares events over a relay. Authenticated device pairing, replay-safe event synchronization and explicit per-device revocation remain unimplemented. That requires a separately designed authenticated device-pairing and transport protocol. No unauthenticated LAN listener is being added merely to make a demo look connected.
