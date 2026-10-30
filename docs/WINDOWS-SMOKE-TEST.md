# Windows desktop smoke-test protocol

Run this protocol on a real Windows 10/11 desktop after downloading the CI artifact. A successful hosted compile is not a substitute for testing window-manager input, audio devices, login startup, or power transitions.

## Test setup

1. Record Windows edition/build, GPU/driver, display count, each display's scale factor, audio output device, and whether WebView2 Runtime is installed.
2. Use a non-admin standard account.
3. Run `miss-minute-desktop.exe`. Enroll only a disposable test directory. Keep automatic note creation disabled for this smoke test.
4. Keep a normal application (Notepad) and a browser window open behind the avatar.

## Overlay and hit testing

- Confirm the avatar is visible, transparent outside its artwork, and remains above normal application windows.
- Move the pointer to empty space inside the overlay's rectangular window but outside the avatar bounds. Click text in Notepad. The click must reach Notepad and must not activate or drag the avatar.
- Move the pointer onto the avatar body. Click once. The avatar may react, and the click must not reach Notepad underneath.
- Drag the avatar slowly across the screen, then quickly across it. Release over both the avatar and empty desktop. The cursor must not remain captured.
- Repeat on each monitor and at 100%, 125%, 150%, and 200% display scaling when available.
- Move the avatar partly across a monitor edge. Confirm hit testing continues to track the avatar's actual screen coordinates.

## Speech and animation

- Enable speech and ask for a short response. Confirm audible output, mouth movement while audio is playing, and a closed/rest mouth after speech ends.
- Disable speech and confirm no audio plays while animation remains functional.
- Lock the workstation and resume. Confirm the audio device and speech behavior recover without restarting the process.
- Check reduced-motion settings and confirm movement is reduced rather than causing layout or input failures.

## Tray and startup

- Close the main dashboard with its window close control. The process should remain in the tray; this is not Quit.
- Reopen dashboard and show/hide avatar from the tray.
- Enable login startup, sign out, and sign back in. Confirm the background argument starts the app with dashboard hidden and tray/overlay available.
- Disable login startup and verify the registration is removed.
- Use the tray Quit action. Confirm both desktop process and agent worker exit.

## Sleep/resume

- With agent monitoring a disposable folder, put Windows to sleep for at least 60 seconds and resume.
- Confirm the agent status is truthful, the watcher either resumes/reconciles or reports a coverage gap, and no crash or duplicate worker appears.
- Confirm the overlay remains interactive and the pointer is not stuck in ignore/drag mode.
- Repeat with the machine locked before sleep.

## Evidence to attach to the PR

Record pass/fail for each section, Windows build, scale factors, and logs. Attach short screen recordings of click-through and drag, startup, and sleep/resume. Redact usernames and private paths. Any failed item is a release blocker; do not mark the Windows interactive smoke test complete based only on GitHub Actions.
